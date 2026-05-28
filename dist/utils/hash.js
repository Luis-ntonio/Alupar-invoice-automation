"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSha256 = createSha256;
const node_crypto_1 = __importDefault(require("node:crypto"));
function createSha256(buffer) {
    return node_crypto_1.default.createHash("sha256").update(buffer).digest("hex");
}
