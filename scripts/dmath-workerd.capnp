using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (
      name = "dmath",
      worker = (
        compatibilityDate = "2026-07-24",
        modules = [
          (
            name = "scripts/dmath-workerd-worker.mjs",
            esModule = embed "dmath-workerd-worker.mjs"
          ),
          (
            name = "dist/engine/dmath.js",
            esModule = embed "../dist/engine/dmath.js"
          )
        ]
      )
    )
  ],
  sockets = [
    (
      name = "http",
      address = "127.0.0.1:0",
      http = (),
      service = "dmath"
    )
  ]
);
