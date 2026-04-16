# Architecture Remediation Sample

Mẫu này bổ sung đầy đủ các phần còn thiếu để có thể dùng như nền tảng production:

- Layer tách biệt: `presentation -> application -> domain -> infrastructure`
- Domain modeling: `User`, `EmailAddress`, business rule trong entity/value object
- DTO/contract typing: `src/architecture/shared/contracts/*`
- API schema chuẩn hóa: `ApiResponse<T>` và error payload thống nhất
- Validation sync type: `zod` schema ở controller
- Error handling có type: `AppError`, `ValidationError`, `Result<T, E>`
- Config management typed: `loadConfig` + `zod`
- Dependency injection/IoC: `Container` + token theo module
- Module structure rõ ràng: feature-based (`modules/users/*`)
- Shared type FE-BE: `shared/contracts/user.ts`
- Testing architecture: unit + integration test bằng `node:test`
- Logging/monitoring abstraction: `Logger`, `Monitor`
- Build pipeline strategy: `tsconfig` strict + `paths` alias + script lint/build/test riêng
- Scalability pattern: modular monolith sẵn sàng tách service theo module token/contracts

## Chạy nhanh

```bash
npm run architecture
npm run test:architecture
```
