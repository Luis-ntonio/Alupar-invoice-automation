"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const cors_1 = __importDefault(require("cors"));
const express_1 = __importDefault(require("express"));
const node_http_1 = __importDefault(require("node:http"));
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("./config");
const routes_1 = __importDefault(require("./routes"));
const coesScheduler_1 = require("./services/coesScheduler");
const realtime_1 = require("./services/realtime");
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: "50mb" }));
app.use(express_1.default.urlencoded({ extended: true }));
app.use("/api", routes_1.default);
app.use(express_1.default.static(node_path_1.default.resolve("public")));
app.get("*", (_req, res) => {
    res.sendFile(node_path_1.default.resolve("public/index.html"));
});
const server = node_http_1.default.createServer(app);
(0, realtime_1.attachWebSocketServer)(server);
server.listen(config_1.config.port, () => {
    console.log(`Proyecto2 API ejecutandose en puerto ${config_1.config.port} (${config_1.config.nodeEnv}).`);
    (0, coesScheduler_1.startCoesScheduler)();
});
