/**
 * Narrow ambient typings for the browser services this client bundle consumes
 * (slots / locale / configForms). Declared locally on purpose: the client
 * bundle must stay free of Host-package runtime imports, and the published
 * client packages' type surfaces are larger than what one panel needs.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SlotRegistrationOptions {
  name: string;
  id?: string;
  key?: string;
  order?: number;
  label?: string | (() => string);
  locale?: string;
  inject?: () => Record<string, unknown>;
}

export interface SlotsService {
  inject(name: string, contribution: () => unknown): () => void;
  register<TComponent>(options: SlotRegistrationOptions, component: TComponent): unknown;
  entries(name: string): Array<{ options: SlotRegistrationOptions; render?: unknown }>;
}

export interface LocaleService {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void;
  bind(namespace: string): (key: string) => string;
}

export interface FormSnapshot {
  status: 'loading' | 'ready' | 'unavailable';
  value: Record<string, unknown> | undefined;
  base: unknown;
  user: unknown;
  revision: number | undefined;
  writable: boolean;
  mode: 'host' | 'memory';
}

export interface ConfigFormFace {
  getSnapshot(): FormSnapshot;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<boolean>;
  unset(field: string): Promise<boolean>;
}

export interface ConfigFormsService {
  get(entryId: string): ConfigFormFace;
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void;
}

export interface ClientContextFace {
  effect(disposer: () => (() => void) | void, label?: string): void;
  slots: SlotsService;
  locale: LocaleService;
  configForms: ConfigFormsService;
}
