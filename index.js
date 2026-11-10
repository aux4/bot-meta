import * as whatsapp from "./lib/whatsapp.js";

(async () => {
  const [action, ...args] = process.argv.slice(2);

  try {
    switch (action) {
      case "whatsapp-verify":
        await whatsapp.verify();
        break;
      case "whatsapp-ingest-parse":
        await whatsapp.ingestParse();
        break;
      case "whatsapp-typing":
        await whatsapp.typing();
        break;
      case "whatsapp-download":
        await whatsapp.download();
        break;
      case "whatsapp-format":
        await whatsapp.format();
        break;
      case "whatsapp-send":
        await whatsapp.send();
        break;
      case "whatsapp-send-template":
        await whatsapp.sendTemplate(args);
        break;
      default:
        process.stderr.write(`Unknown action: ${action}\n`);
        process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  }
})();
