import {
  BadRequest,
  Conflict,
  InternalServerError,
  MethodNotAllowed,
  NotFound,
  ServiceError,
} from './errors'
import type { HookConfig, HookFn, Hooks } from './hook'
import Manifest, { CollectionConfig } from './manifest'
import Schema, { ValidationError } from './schema'
import CollectionService from './collection-service'
import type { Context } from './context'
import { Database } from './database'
import HooksRegistry from './hooks-registry'
import Method from './method'
import { createRouter } from 'radix3'

const INTERNAL_PATHS = ['collections', 'hooks']
const DEV = ['development', 'test', undefined].includes(process.env.NODE_ENV)

type Handle = (ctx: Context, app: App) => Promise<Context>

interface Service {
  handle: Handle
}

class Pipeline {
  private app: App
  private service: Service
  private hooks: Hooks = Pipeline.stubHooks()

  constructor(app: App, service: Service) {
    this.app = app
    this.service = service
  }

  async run(ctx: Context): Promise<Context> {
    // run app before hooks

    for (const [hook, config] of this.hooks.before[ctx.method]) {
      try {
        ctx = await hook(ctx, config, this.app)

        if (ctx.result) {
          // if there's already a result, we wouldn't want it to be overwritten
          // by subsequent hooks or the service. Maybe this was provided from some
          // cache or something.
          break
        }
      } catch (err) {
        return Pipeline.handleError(err, ctx)
      }
    }

    if (!ctx.result) {
      try {
        ctx = await this.service.handle(ctx, this.app)
        if (ctx.method !== 'remove' && !ctx.result) {
          throw new NotFound()
        }
      } catch (err) {
        return Pipeline.handleError(err, ctx)
      }
    }

    for (const [hook, config] of this.hooks.after[ctx.method]) {
      try {
        ctx = await hook(ctx, config, this.app)
      } catch (err) {
        return Pipeline.handleError(err, ctx)
      }
    }

    // run app after-hooks

    if (!ctx.statusCode) {
      ctx.statusCode = 200
    }

    return ctx
  }

  hook(
    when: 'after' | 'before',
    method: `${Method}`,
    hook: HookFn,
    config?: HookConfig
  ) {
    if (when === 'after') {
      return this.after(method, hook, config)
    }

    return this.before(method, hook, config)
  }

  after(method: `${Method}`, hook: HookFn, config?: HookConfig): Pipeline {
    this.hooks.after[method].push([hook, config])
    return this
  }

  before(method: `${Method}`, hook: HookFn, config?: HookConfig): Pipeline {
    this.hooks.before[method].push([hook, config])
    return this
  }

  static handleError(err: any, ctx: Context): Context {
    // TODO: put into logs

    const error =
      err instanceof ServiceError ? err : Pipeline.translateError(err)

    ctx.result = {
      details: error.data,
      error: error.message || error.name,
    }

    ctx.statusCode = error.statusCode

    return ctx
  }

  static translateError(err: any) {
    if (err instanceof ValidationError) {
      return new BadRequest(err.message, err.detail)
    }

    DEV && console.error(err)

    return new InternalServerError(`Unknown error: ${err.message}`, err)
  }

  static stubHooks(): Hooks {
    return {
      after: {
        create: [],
        find: [],
        get: [],
        patch: [],
        remove: [],
      },
      before: {
        create: [],
        find: [],
        get: [],
        patch: [],
        remove: [],
      },
    }
  }
}

class AnonymouseService implements Service {
  handle: Handle

  constructor(handle: Handle) {
    this.handle = handle
  }
}

const collectionsService: Service & { schema: Schema } = {
  async handle(ctx: Context, app: App) {
    switch (ctx.method) {
      case 'create': {
        if (ctx.params?.id) {
          throw new MethodNotAllowed(
            '`create` method not allowed on detail path'
          )
        }

        if (await app.manifest.collection(ctx.data?.name)) {
          throw new Conflict(
            `A collection with name \`${ctx.data?.name}\` already exists`
          )
        }

        const data = this.schema.validate(ctx.data, true)
        Schema.validateSchema(data.schema)

        const collection = await app.manifest.collection(data.name, data)

        app.use(collection.name, new CollectionService(app, collection.name))

        ctx.result = collection
        ctx.statusCode = 201
        return ctx
      }

      case 'find': {
        const nameSort = Number(ctx.query.$sort?.name || '1')
        const collections = await app.manifest.collections()
        ctx.result = collections.sort(
          (a, b) => a.name.localeCompare(b.name) * nameSort
        )
        return ctx
      }

      case 'get': {
        const collection = await app.manifest.collection(ctx.params!.id)
        ctx.result = collection

        return ctx
      }

      case 'patch': {
        if (!ctx.params?.id) {
          throw new MethodNotAllowed('`patch` method not allowed on base path')
        }

        const existing = await app.manifest.collection(ctx.params!.id)

        if (!existing) {
          throw new NotFound()
        }

        const patch = await this.schema.validate(ctx.data, false, true)
        if (patch.schema) {
          Schema.validateSchema(patch.schema)
        }

        const collectionConfig = {
          ...existing,
          ...patch,
        }
        const collection = await app.manifest.collection(
          collectionConfig.name,
          collectionConfig
        )

        await app.installCollection(collection)
        if (existing.name !== collection.name) {
          await app.manifest.removeCollection(existing.name)
          app.leave(existing.name)
        }

        ctx.result = collection

        return ctx
      }

      case 'remove': {
        await app.manifest.removeCollection(ctx.params!.id)
        app.leave(ctx.params!.id)
        return ctx
      }
    }
  },

  schema: new Schema({
    exposed: { defaultValue: true, type: 'boolean' },
    name: { required: true, type: 'string' },
    schema: { required: true, type: 'any' },
    template: { defaultValue: false, type: 'boolean' },
  }),
}

const hooksRegistry: Service = {
  async handle(ctx, app) {
    switch (ctx.method) {
      case 'find': {
        ctx.result = app.hooksRegistry.list()

        return ctx
      }

      default:
        throw new MethodNotAllowed()
    }
  },
}

const hooksService: Service = {
  async handle(ctx, app) {
    switch (ctx.method) {
      case 'patch': {
        // the id is the collection name
        const collection = ctx.params?.id as string
        await app.manifest.setHooks(collection, ctx.data)

        ctx.result = await app.manifest.getHooks(collection)

        return ctx
      }

      case 'get': {
        const hooks = await app.manifest.getHooks(ctx.params!.id)
        ctx.result = hooks

        return ctx
      }

      default: {
        throw new MethodNotAllowed()
      }
    }
  },
}

interface Options {
  db: Database
}

class App {
  private routes = createRouter()
  database: Database
  manifest: Manifest
  hooksRegistry: HooksRegistry

  private initialize: Promise<void>

  constructor(options: Options) {
    this.database = options.db
    this.manifest = new Manifest()
    this.hooksRegistry = new HooksRegistry()

    this.initialize = (async () => {
      this.addService('collections', collectionsService)
      this.addService('hooks-registry', hooksRegistry)
      this.addService('hooks', hooksService)

      this.installCollectionsServices()
    })()
  }

  async init() {
    return this.initialize
  }

  use(path: string, handle: Handle): Pipeline
  use(path: string, service: Service): Pipeline
  use(path: string, handleOrService: Service | Handle): Pipeline {
    if (INTERNAL_PATHS.includes(path)) {
      throw new Error(
        `path \`${path}\` is an internal path. Overriding it will cause problems.`
      )
    }

    const service: Service =
      typeof handleOrService === 'function'
        ? new AnonymouseService(handleOrService)
        : handleOrService

    return this.addService(path, service)
  }

  leave(path: string) {
    this.routes.remove(`${path}`)
    this.routes.remove(`${path}/:id`)
  }

  private addService(path: string, service: Service) {
    const pipeline = new Pipeline(this, service)
    this.register(`${path}`, pipeline)
    this.register(`${path}/:id`, pipeline)

    return pipeline
  }

  private register(path: string, pipeline: Pipeline) {
    this.routes.insert(path, { pipeline })
  }

  async api(ctx: Context): Promise<Context> {
    await this.init()

    const route = this.routes.lookup(ctx.path)
    if (!route) {
      const err = new NotFound(`No service/handler found for path ${ctx.path}`)
      return Pipeline.handleError(err, ctx)
    }

    ctx.params = route.params
    if (route.params?.id && ctx.method === 'find') {
      ctx.method = 'get'
    }

    const pipeline = route.pipeline as Pipeline

    return await pipeline.run(ctx)
  }

  async installCollectionsServices() {
    const collections = await this.manifest.collections()
    for (const collection of collections) {
      await this.installCollection(collection)
    }
  }

  async installCollection(collection: CollectionConfig) {
    if (!collection.exposed) {
      this.leave(collection.name)

      return
    }

    const pipeline = this.use(
      collection.name,
      new CollectionService(this, collection.name)
    )

    const hooks = await this.manifest.getHooks(collection.name)
    if (!hooks) {
      return
    }

    for (const when of ['before', 'after'] as const) {
      for (const [method, hookList] of Object.entries(hooks[when])) {
        for (const [hookId, config] of hookList) {
          const hook = this.hooksRegistry.get(hookId)
          if (!hook) {
            throw new Error(`No hook with id: "${hookId}" exists.`)
          }

          pipeline.hook(when, method as Method, hook.run, config)
        }
      }
    }
  }

  async admin(path: string, queryParams?: string) {
    await this.init()

    const trimmedPath = path.replace(/^\//, '')
    const fileDir = `${__dirname}/admin/${trimmedPath}`

    return fileDir
  }

  serve<T>(server: (app: App) => T): T {
    return server(this)
  }
}

export default App
export { Pipeline, INTERNAL_PATHS }
export type { Handle, Service }
