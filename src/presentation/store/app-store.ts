export interface AppStore {
  currentUserId: string | null;
}

export const createAppStore = (): AppStore => ({
  currentUserId: null,
});
