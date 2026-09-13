let requests = 0;
self.onmessage = ({data}) => {
  if ("init" in data) { self.postMessage({ready: true}); return; }
  self.postMessage({id: data.id, payload: `${++requests}:${data.payload}`});
};
