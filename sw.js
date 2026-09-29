const CACHE="muj-plan-v21";

self.addEventListener("install",event=>{
  event.waitUntil(
    caches.open(CACHE)
      .then(cache=>cache.addAll(["./","./index.html","./manifest.json"]))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET")return;
  event.respondWith(
    fetch(event.request).then(response=>{
      const copy=response.clone();
      caches.open(CACHE).then(cache=>cache.put(event.request,copy)).catch(()=>{});
      return response;
    }).catch(()=>caches.match(event.request).then(response=>response||caches.match("./index.html")))
  );
});

self.addEventListener("push",event=>{
  let data={};
  try{data=event.data?event.data.json():{};}catch(_){data={body:event.data?.text()||"Máš naplánovaný úkol."};}
  const notification=data.notification || data;
  const title=notification.title || data.title || "Můj plán";
  const options={
    body:notification.body || data.body || "Máš naplánovaný úkol.",
    tag:notification.tag || data.taskId || "plan-reminder",
    data:{url:notification.navigate || data.url || "./"},
    icon:"./icon-192.png",
    badge:"./icon-192.png"
  };
  event.waitUntil(self.registration.showNotification(title,options));
});

self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const url=event.notification.data?.url||"./";
  event.waitUntil(
    clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
      for(const client of list){
        if("focus" in client){
          client.focus();
          return;
        }
      }
      if(clients.openWindow)return clients.openWindow(url);
    })
  );
});
