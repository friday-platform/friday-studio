BEGIN;

SELECT plan(8);

-- Test _tempest schema exists
SELECT has_schema('_tempest', '_tempest schema should exist');

-- Test _tempest.shortid() function exists and works
SELECT has_function('_tempest', 'shortid', ARRAY[]::text[], 'shortid function should exist');
SELECT matches(
  _tempest.shortid(),
  '^[a-zA-Z0-9]+$',
  'shortid should return alphanumeric string'
);

-- Test _tempest.updated_at() function exists
SELECT has_function('_tempest', 'updated_at', ARRAY[]::text[], 'updated_at function should exist');

-- Test bounce schema exists
SELECT has_schema('bounce', 'bounce schema should exist');

-- Test bounce.auth_user table exists with correct columns
SELECT has_table('bounce', 'auth_user', 'auth_user table should exist');
SELECT has_column('bounce', 'auth_user', 'id', 'auth_user should have id column');
SELECT has_column('bounce', 'auth_user', 'email', 'auth_user should have email column');

SELECT * FROM finish();

ROLLBACK;
