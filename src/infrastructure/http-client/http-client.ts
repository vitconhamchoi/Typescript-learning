export interface HttpClient {
  get<T>(url: string): Promise<T>;
}

export class FetchHttpClient implements HttpClient {
  async get<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP GET failed: ${response.status} ${response.statusText} (${url})`);
    }

    return (await response.json()) as T;
  }
}
