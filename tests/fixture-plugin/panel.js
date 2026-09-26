window.mxdeck.on("pushed", (v) => window.mxdeck.invoke("got-push", v));
window.mxdeck.invoke("ping", 42);
