import cors from "cors";
import express from "express";
import http from "node:http";
import path from "node:path";
import { config } from "./config";
import router from "./routes";
import { startCoesScheduler } from "./services/coesScheduler";
import { attachWebSocketServer } from "./services/realtime";

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Los estaticos (renderer.js, styles.css, index.html) cambian en cada deploy.
// "no-cache" permite que el navegador los cachee pero lo obliga a revalidar via
// ETag antes de usarlos, de modo que tras un deploy siempre baja la version nueva
// sin requerir recarga forzada del usuario.
app.use(
  express.static(path.resolve("public"), {
    setHeaders: (res, filePath) => {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  })
);

app.get("*", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.resolve("public/index.html"));
});

const server = http.createServer(app);
attachWebSocketServer(server);

server.listen(config.port, () => {
  console.log(`Proyecto2 API ejecutandose en puerto ${config.port} (${config.nodeEnv}).`);
  startCoesScheduler();
});
