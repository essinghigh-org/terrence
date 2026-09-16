/** Shared structural types used by backend library boundaries. */
export type DeepReadonly<T> =
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- tsc TS6133 requires the underscore on unused infer bindings; the name is never referenced by design
  T extends (...args: infer _Args) => infer _Return
    ? T
    : T extends boolean | number | string | symbol | bigint | null | undefined
      ? T
      : T extends ReadonlySet<infer Item>
        ? ReadonlySet<DeepReadonly<Item>>
        : T extends readonly (infer Item)[]
          ? readonly DeepReadonly<Item>[]
          : T extends object
            ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
            : T;

export type RequestWithUrl = Readonly<{ readonly url: string }>;
