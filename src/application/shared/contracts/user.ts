export interface CreateUserRequest {
  email: string;
  displayName: string;
  age: number;
}

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  age: number;
  createdAt: string;
}

export type CreateUserResponse = UserDto;
