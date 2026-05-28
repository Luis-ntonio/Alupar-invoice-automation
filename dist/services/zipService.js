"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateZipByConcept = generateZipByConcept;
const archiver_1 = __importDefault(require("archiver"));
const node_fs_1 = require("node:fs");
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
async function generateZipByConcept(documents, concept, requestId, blobStorage) {
    if (documents.length === 0) {
        throw new Error(`No hay documentos para el concepto ${concept}.`);
    }
    const tempZipPath = node_path_1.default.join(node_os_1.default.tmpdir(), `${requestId}-${concept}.zip`);
    const output = (0, node_fs_1.createWriteStream)(tempZipPath);
    const archive = (0, archiver_1.default)("zip", { zlib: { level: 9 } });
    const done = new Promise((resolve, reject) => {
        output.on("close", () => resolve());
        output.on("error", (error) => reject(error));
        archive.on("error", (error) => reject(error));
    });
    archive.pipe(output);
    for (const doc of documents) {
        const stream = await blobStorage.openReadStream(doc.sourcePath);
        archive.append(stream, { name: `${doc.id}-${doc.fileName}` });
    }
    await archive.finalize();
    await done;
    const exportPath = await blobStorage.saveExport(tempZipPath, requestId, concept);
    await node_fs_1.promises.unlink(tempZipPath);
    return exportPath;
}
