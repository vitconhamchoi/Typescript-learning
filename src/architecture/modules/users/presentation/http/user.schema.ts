import { z } from "zod";

export const CreateUserRequestSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(3),
  age: z.number().int().min(13),
});

export const UserResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(3),
  age: z.number().int().min(13),
  createdAt: z.string().datetime(),
});
