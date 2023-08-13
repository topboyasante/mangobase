import App from './app'
import CollectionService from './collection-service'
import { SchemaDefinitions } from './schema'

const usersSchema: SchemaDefinitions = {
  avatar: { type: 'string' },
  email: { required: true, type: 'string', unique: true },
  fullname: { required: true, type: 'string' },
  // basic, super-admin, admin
  role: { defaultValue: 'basic', required: true, type: 'string' },
  username: { required: true, type: 'string', unique: true },
  verified: { type: 'boolean' },
}

// [ ] Validate users schema to make sure it's not corrupted
// [ ] Run migration on changes
async function users(app: App) {
  if (!(await app.manifest.collection('users'))) {
    await app.manifest.collection('users', {
      exposed: true,
      name: 'users',
      schema: usersSchema,
    })
  }

  app.use('users', new CollectionService(app, 'users'))
}

export default users
