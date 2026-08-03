# LDAP test fixture dependency

`ldapjs` is retained as a test-only development dependency because the LDAP
flow suite needs an in-process bind/search server. Production authentication
uses `ldapts`; replace this fixture with a maintained LDAP test server when a
drop-in server supports the same bind, search, and StartTLS coverage.
