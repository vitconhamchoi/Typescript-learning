export interface CreateTodoRequest {
  userId: string;
  title: string;
}

export interface TodoDto {
  id: string;
  userId: string;
  title: string;
  completed: boolean;
  createdAt: string;
}

export type CreateTodoResponse = TodoDto;
