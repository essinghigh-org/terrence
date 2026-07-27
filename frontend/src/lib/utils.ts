import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

type DeepReadonly<T> = T extends null | undefined
  ? T
  : T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

export function cn(...inputs: readonly DeepReadonly<ClassValue>[]): string {
  return twMerge(clsx(inputs));
}
