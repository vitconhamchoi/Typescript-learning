import { ValidationError } from "../../shared/errors.js";
import { err, ok, type Result } from "../../shared/result.js";

import { TodoTitle } from "../value-objects/todo-title.js";

export interface NewTodoProps {
  id: string;
  userId: string;
  title: TodoTitle;
  completed: boolean;
  createdAt: Date;
}

export class Todo {
  private constructor(private readonly props: NewTodoProps) {}

  static create(props: NewTodoProps): Result<Todo, ValidationError> {
    const userId = props.userId.trim();
    if (userId.length === 0) {
      return err(new ValidationError("Todo must belong to a user"));
    }

    return ok(new Todo({ ...props, userId }));
  }

  get id(): string {
    return this.props.id;
  }

  get userId(): string {
    return this.props.userId;
  }

  get title(): TodoTitle {
    return this.props.title;
  }

  get completed(): boolean {
    return this.props.completed;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }
}
