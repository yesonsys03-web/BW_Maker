export async function appDataDir(): Promise<string> { return "/demo"; }
export async function join(...parts: string[]): Promise<string> { return parts.join("/"); }
