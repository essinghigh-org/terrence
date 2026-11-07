package recorder

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEntitlementCAAcceptsPinnedPublicCertificatesOnly(t *testing.T) {
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, e := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if e != nil {
		t.Fatal(e)
	}
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	for _, test := range []struct {
		name  string
		data  []byte
		valid bool
	}{
		{"public", cert, true}, {"private key", pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte("private")}), false},
		{"leading-space hidden block", append([]byte("  -----BEGIN CERTIFICATE-----\nhidden non-PEM text\n"), cert...), false},
		{"hidden prefix", append([]byte("private prefix\n"), cert...), false}, {"trailing data", append(append([]byte{}, cert...), []byte("private suffix")...), false}, {"empty", nil, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "ca.pem")
			if e := os.WriteFile(path, test.data, 0400); e != nil {
				t.Fatal(e)
			}
			sum := sha256.Sum256(test.data)
			c := &Certificate{Path: path, SHA256: hex.EncodeToString(sum[:])}
			if e := c.validate(); (e == nil) != test.valid {
				t.Fatal("certificate validation mismatch", e)
			}
			if test.valid {
				c.SHA256 = strings.Repeat("0", 64)
				if c.validate() == nil {
					t.Fatal("unpinned trust root accepted")
				}
			}
		})
	}
}
