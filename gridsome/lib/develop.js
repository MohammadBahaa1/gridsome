const fs = require('fs-extra')
const chalk = require('chalk')
const { debounce } = require('lodash')
const resolvePort = require('./server/resolvePort')
const { prepareUrls } = require('./server/utils')

module.exports = async (context, args) => {
  process.env.NODE_ENV = 'development'
  process.env.GRIDSOME_MODE = 'serve'

  const createApp = require('./app')
  const Server = require('./server/Server')

  const app = await createApp(context, { args })
  const port = await resolvePort(app.config.port)
  const hostname = app.config.host
  const urls = prepareUrls(hostname, port)
  const server = new Server(app, urls)

  await app.events.dispatch('configureServer', null, server)

  await fs.emptyDir(app.config.cacheDir)

  const webpackConfig = await createWebpackConfig(app)
  const compiler = require('webpack')(webpackConfig)

  server.hooks.setup.tap('develop', server => {
    server.use(require('webpack-hot-middleware')(compiler, {
      quiet: true,
      log: false
    }))
  })

  server.hooks.afterSetup.tap('develop', server => {
    const devMiddleware = require('webpack-dev-middleware')(compiler, {
      pathPrefix: webpackConfig.output.pathPrefix,
      logLevel: 'silent'
    })

    server.use(devMiddleware)
  })

  compiler.hooks.done.tap('develop', stats => {
    if (stats.hasErrors()) {
      return
    }

    console.log()
    console.log(`  Site running at:          ${chalk.cyan(urls.local.pretty)}`)
    console.log(`  Explore GraphQL data at:  ${chalk.cyan(urls.explore.pretty)}`)
    console.log()
  })

  server.listen(port, hostname, err => {
    if (err) throw err
  })

  const createPages = debounce(() => app.createPages(), 16)
  const fetchQueries = debounce(() => app.broadcast({ type: 'fetch' }), 16)
  const generateRoutes = debounce(() => app.codegen.generate('routes.js'), 16)

  app.store.on('change', createPages)
  app.pages.on('create', generateRoutes)
  app.pages.on('remove', generateRoutes)

  app.pages.on('update', (page, oldPage) => {
    const { path: oldPath, query: oldQuery } = oldPage
    const { path, query } = page

    if (
      (path !== oldPath && !page.internal.isDynamic) ||
      // pagination was added or removed in page-query
      (query.paginate && !oldQuery.paginate) ||
      (!query.paginate && oldQuery.paginate) ||
      // page-query was created or removed
      (query.document && !oldQuery.document) ||
      (!query.document && oldQuery.document)
    ) {
      return generateRoutes()
    }

    fetchQueries()
  })

  //
  // helpers
  //

  async function createWebpackConfig (app) {
    const config = await app.resolveChainableWebpackConfig()

    config
      .plugin('friendly-errors')
      .use(require('friendly-errors-webpack-plugin'))

    config
      .plugin('injections')
      .tap(args => {
        const definitions = args[0]
        args[0] = {
          ...definitions,
          'process.env.SOCKJS_ENDPOINT': JSON.stringify(urls.sockjs.url),
          'process.env.GRAPHQL_ENDPOINT': JSON.stringify(urls.graphql.url)
        }
        return args
      })

    config.entryPoints.store.forEach((entry, name) => {
      config.entry(name)
        .prepend(`webpack-hot-middleware/client?name=${name}&reload=true&noInfo=true`)
        .prepend('webpack/hot/dev-server')
    })

    return app.resolveWebpackConfig(false, config)
  }
}
