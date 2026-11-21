const CACHE='nova-install-ui-v1';
self.addEventListener('install',e=>{self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(self.clients.claim())});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  // never cache API/install
  if(u.pathname.indexOf('/install')===0||u.pathname.indexOf('/api')===0||u.pathname.indexOf('/health')===0) return;
  // network-first for HTML
});
