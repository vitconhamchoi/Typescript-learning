export type Token<T> = symbol;

type Factory<T> = (container: Container) => T;

export class Container {
  private readonly factories = new Map<symbol, Factory<unknown>>();
  private readonly singletons = new Map<symbol, unknown>();

  registerValue<T>(token: Token<T>, value: T): void {
    this.singletons.set(token, value);
  }

  registerFactory<T>(token: Token<T>, factory: Factory<T>): void {
    this.factories.set(token, factory as Factory<unknown>);
  }

  resolve<T>(token: Token<T>): T {
    if (this.singletons.has(token)) {
      return this.singletons.get(token) as T;
    }

    const factory = this.factories.get(token);
    if (!factory) {
      throw new Error(`Missing dependency for token: ${String(token)}`);
    }

    const instance = factory(this);
    this.singletons.set(token, instance);

    return instance as T;
  }
}
