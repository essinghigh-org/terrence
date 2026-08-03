/**
 * Minimal ambient typing for `ldapjs` as used by the LDAP mock server in tests.
 * The published @types/ldapjs package is incomplete for the server API surface
 * the LDAP flow tests exercise (bind/search handlers, createServer), so we keep
 * a small local declaration instead.
 */
declare module "ldapjs" {
  export type BindRequest = {
    dn: { toString(): string };
    credentials: string;
  };
  export type SearchRequest = {
    dn: { toString(): string };
    filter: { value?: string } & { attributeValue?: string };
  };
  export type Response = {
    end(): void;
    // Real LDAP attributes may hold multiple string/Buffer values; the mock
    // uses a wide record so tests can exercise such entries.
    send(entry: { dn: string; attributes: Record<string, string | string[] | Buffer> }): void;
  };
  export type NextCallback = (err?: Error) => void;
  export type Server = {
    bind(name: string, handler: (req: BindRequest, res: Response, next: NextCallback) => void): void;
    search(name: string, handler: (req: SearchRequest, res: Response, next: NextCallback) => void): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    listen(port: number, host: string, callback: () => void): void;
    address(): { port: number } | string | null;
    close(callback?: () => void): void;
  };
  export function createServer(): Server;
  export class InvalidCredentialsError extends Error {}
}