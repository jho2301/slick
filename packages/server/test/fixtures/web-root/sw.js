// The shape the daemon's build-stamp rewrite looks for: a single-quoted
// placeholder it replaces with the digest of the tree it is serving.
const BUILD = '__BUILD__';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => console.log('test worker', BUILD));
