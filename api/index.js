// Vercel serverless entry — mọi path rewrite về đây (xem vercel.json).
import { buildApp } from '../src/app.js';

let _appP;
function getApp() {
  if (!_appP) _appP = buildApp().then((app) => app.ready().then(() => app));
  return _appP;
}

export default async function handler(req, res) {
  const app = await getApp();
  app.server.emit('request', req, res);
}
