// Runs in the page's own JS world. When a page attaches a shadow root to an element
// that is already on the page, tell the content script so it can scan inside it.
(() => {
  const proto = Element.prototype;
  const original = proto.attachShadow;
  if (!original || original.__lbHooked) return;
  const hooked = function attachShadow(init) {
    const root = original.call(this, init);
    const host = this;
    queueMicrotask(() => {
      if (host.isConnected) {
        host.dispatchEvent(new CustomEvent('logoblur:shadow', { bubbles: true, composed: true }));
      }
    });
    return root;
  };
  hooked.__lbHooked = true;
  hooked.toString = () => original.toString();
  proto.attachShadow = hooked;
})();
