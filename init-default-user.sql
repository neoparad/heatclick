-- デフォルトユーザーの作成
-- パスワード: admin123 (bcryptハッシュ)
INSERT INTO clickinsight.users (id, email, password, name, created_at, updated_at, plan, status)
VALUES (
  'default-admin-001',
  'admin@example.com',
  '$2a$10$rQ8WvLKz.5rGX9YvH8gJXeTXNjZvB8pXzD8WsYxZ0Y4K4U3yZ8zJC',
  'Default Admin',
  '2025-11-12 00:00:00',
  '2025-11-12 00:00:00',
  'free',
  'active'
);
