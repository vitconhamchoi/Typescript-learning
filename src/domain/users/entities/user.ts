import { ValidationError } from "../../shared/errors.js";
import { err, ok, type Result } from "../../shared/result.js";

import { EmailAddress } from "../value-objects/email-address.js";

export interface NewUserProps {
  id: string;
  email: EmailAddress;
  displayName: string;
  age: number;
  createdAt: Date;
}

export class User {
  private constructor(private readonly props: NewUserProps) {}

  static create(props: NewUserProps): Result<User, ValidationError> {
    const displayName = props.displayName.trim();

    if (displayName.length < 3) {
      return err(new ValidationError("Display name must be at least 3 characters"));
    }

    if (props.age < 13) {
      return err(new ValidationError("User must be at least 13 years old", { minAge: 13 }));
    }

    return ok(new User({ ...props, displayName }));
  }

  get id(): string {
    return this.props.id;
  }

  get email(): EmailAddress {
    return this.props.email;
  }

  get displayName(): string {
    return this.props.displayName;
  }

  get age(): number {
    return this.props.age;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }
}
