// A stand-in for the built worker: served byte for byte, never rewritten.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => console.log('test worker'));
