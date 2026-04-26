# 5 nền tảng JavaScript cần nắm để làm Angular tốt hơn

Nhiều vấn đề khi làm Angular không đến từ framework, mà đến từ việc hiểu chưa chắc JavaScript. Angular có thể che bớt độ phức tạp, nhưng không thay đổi bản chất của ngôn ngữ phía dưới. Nếu muốn code Angular chắc tay hơn, có 5 nền tảng cần nắm rõ.

## 1. Function là giá trị

Trong JavaScript, function không chỉ là “hàm để gọi”, mà còn là một giá trị có thể truyền vào chỗ khác, trả về từ hàm khác hoặc dùng để tổ chức logic.

```ts
function run(fn: (x: number) => number, value: number) {
  return fn(value);
}

console.log(run(x => x * 2, 5)); // 10
```

Điều này rất quan trọng trong Angular vì rất nhiều API dựa trên function:
- callback xử lý sự kiện
- RxJS operator như `map`, `filter`, `switchMap`
- factory provider
- guard, interceptor

```ts
this.http.get<User[]>('/api/users')
  .pipe(map(users => users.filter(x => x.active)))
  .subscribe(console.log);
```

Nếu không quen tư duy function là giá trị, rất khó đọc code RxJS và các luồng xử lý bất đồng bộ trong Angular.

## 2. Scope và closure

Closure là khả năng function ghi nhớ biến ở scope nơi nó được tạo ra.

```ts
function createCounter() {
  let count = 0;
  return function () {
    count++;
    return count;
  };
}

const counter = createCounter();
console.log(counter()); // 1
console.log(counter()); // 2
```

Trong Angular, closure xuất hiện ở rất nhiều nơi:
- callback trong `subscribe`
- event handler
- hàm bên trong service
- async logic với timer, promise, observable

```ts
for (var i = 0; i < 3; i++) {
  setTimeout(() => console.log(i), 100);
}
// 3, 3, 3
```

```ts
for (let i = 0; i < 3; i++) {
  setTimeout(() => console.log(i), 100);
}
// 0, 1, 2
```

Hiểu scope và closure giúp tránh các lỗi kiểu callback giữ sai biến, logic async chạy không như kỳ vọng hoặc state bị dùng lệch thời điểm.

## 3. Object là reference

Object trong JavaScript được xử lý theo reference. Hai object giống nội dung chưa chắc bằng nhau.

```ts
const a = { name: 'Viet' };
const b = { name: 'Viet' };

console.log(a === b); // false
```

Điều này liên quan trực tiếp đến Angular khi làm việc với:
- state
- input object
- form model
- change detection
- immutable update

```ts
const user = { name: 'Viet', age: 28 };
const sameUser = user;

sameUser.name = 'Anh Viet';

console.log(user.name); // Anh Viet
```

Nếu mutate object trực tiếp, hiệu ứng dây chuyền rất dễ xảy ra. Khi app lớn lên, việc clone rõ ràng hoặc update theo kiểu immutable thường an toàn hơn.

```ts
const updatedUser = { ...user, name: 'Anh Viet' };
```

Hiểu reference giúp giảm lỗi liên quan đến UI không cập nhật như mong muốn hoặc dữ liệu bị thay đổi ngoài ý muốn.

## 4. JavaScript có nhiều bẫy ngôn ngữ

Nhiều bug không phải do Angular, mà do đặc điểm của JavaScript như coercion, truthy/falsy, `null`, `undefined`, mutation.

```ts
console.log(0 == false);  // true
console.log(0 === false); // false
```

```ts
if ('0') {
  console.log('runs');
}
```

```ts
if (0) {
  console.log('will not run');
}
```

Trong Angular, những bẫy này dễ xuất hiện khi:
- kiểm tra điều kiện trong template
- xử lý form value
- đọc dữ liệu từ API
- merge object
- kiểm tra dữ liệu rỗng

Ví dụ:
```ts
if (user.age) {
  // age = 0 sẽ không vào đây
}
```

An toàn hơn là kiểm tra rõ:
```ts
if (user.age !== null && user.age !== undefined) {
  // rõ ràng hơn
}
```

Hiểu những bẫy này giúp code bớt “chạy được nhưng sai”.

## 5. Code đơn giản, tách trách nhiệm rõ ràng

JavaScript cho phép viết rất nhanh, nhưng càng viết dồn logic thì càng khó đọc và khó maintain. Angular đặc biệt cần tư duy tách trách nhiệm vì codebase thường lớn.

Ví dụ viết dồn:
```ts
if (user && user.active && user.role === 'admin' && user.age > 18) {
  this.router.navigate(['/dashboard']);
}
```

Viết rõ hơn:
```ts
function isAdult(user: User) {
  return user.age > 18;
}

function isAdmin(user: User) {
  return user.role === 'admin';
}

function canAccessDashboard(user: User) {
  return user.active && isAdult(user) && isAdmin(user);
}
```

Tư duy này áp dụng tốt trong Angular:
- component mỏng
- business logic đặt ở service
- function nhỏ, rõ trách nhiệm
- observable flow dễ đọc
- template không nhồi quá nhiều điều kiện

Code đơn giản không chỉ đẹp hơn mà còn giảm chi phí debug và bảo trì.

## Kết luận

5 nền tảng cần nắm chắc để làm Angular tốt hơn là:
- function là giá trị
- scope và closure
- object và reference
- các bẫy của JavaScript
- tư duy viết code đơn giản

Angular giúp tổ chức ứng dụng tốt, nhưng JavaScript mới là lớp nền thực sự. Khi lớp nền chắc, việc đọc code, debug, xử lý async, quản lý state và bảo trì dự án sẽ dễ hơn rất nhiều.
