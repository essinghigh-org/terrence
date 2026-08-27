# LDAP test fixture dependency

The LDAP flow suite uses the pinned `osixia/openldap:1.5.0` container as an
external test directory. The fixture starts a uniquely named container with an
ephemeral host port, waits for a real StartTLS healthcheck, seeds the test
users through the maintained `ldapts` client, and removes the container after
the suite.

Docker must be available to run `backend/tests/api/ldap_flow.test.ts` locally
and in CI. The test does not use a fixed LDAP port or persistent volumes, so
parallel test jobs and concurrent local runs remain isolated.

Production LDAP authentication uses `ldapts` directly. The fixture also
performs a StartTLS bind/search during setup so the external server's TLS
capability is verified rather than merely configured.
