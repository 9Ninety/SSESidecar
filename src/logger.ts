export class Logger {
  private timestamp() {
    return new Date().toISOString().replace("T", " ").slice(0, -1);
  }
  info(message: string) {
    console.log(`[${this.timestamp()}] ${message}`);
  }
  error(message: string, err?: unknown) {
    console.error(`[${this.timestamp()}] ${message}`);
    if (err != null) console.error(err);
  }
}
