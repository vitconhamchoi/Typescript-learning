export abstract class BaseRepository<TKey, TEntity> {
  protected readonly entities = new Map<TKey, TEntity>();

  protected getByKey(key: TKey): TEntity | null {
    return this.entities.get(key) ?? null;
  }

  protected setByKey(key: TKey, entity: TEntity): void {
    this.entities.set(key, entity);
  }
}
