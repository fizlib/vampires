const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function (app) {
    app.use(
        createProxyMiddleware('/socket.io', {
            target: 'http://127.0.0.1:3001',
            changeOrigin: true,
            secure: false, // Accept self-signed certs
            ws: true      // Enable WS proxying
        })
    );
};
