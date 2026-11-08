package recorder

import (
	"bytes"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"io"
	"os"
	"syscall"
)

// A pinned public CA bundle supports operators' private Terrence PKI. This is
// never a TLS-verification bypass and cannot supply a private key to children.
type Certificate struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

func (c *Certificate) validate() error {
	if c == nil {
		return nil
	}
	if e := canonical(c.Path); e != nil {
		return e
	}
	f, e := os.OpenFile(c.Path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if e != nil {
		return errors.New("cannot open pinned entitlement CA")
	}
	defer f.Close()
	s, e := f.Stat()
	if e != nil || !s.Mode().IsRegular() || s.Mode().Perm()&0222 != 0 || s.Size() > 1<<20 {
		return errors.New("entitlement CA must be an immutable bounded regular file")
	}
	if st, ok := s.Sys().(*syscall.Stat_t); !ok || st.Nlink != 1 {
		return errors.New("entitlement CA must not be hard linked")
	}
	data, e := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if e != nil || len(data) > 1<<20 {
		return errors.New("cannot read pinned entitlement CA")
	}
	hash := sha256.Sum256(data)
	if c.SHA256 != hex.EncodeToString(hash[:]) {
		return errors.New("entitlement CA digest mismatch")
	}
	count := 0
	for len(bytes.TrimSpace(data)) > 0 {
		data = bytes.TrimSpace(data)
		if !bytes.HasPrefix(data, []byte("-----BEGIN CERTIFICATE-----")) {
			return errors.New("entitlement CA must contain public certificates only")
		}
		// Decode only the first block: pem.Decode otherwise skips malformed text
		// before a later valid certificate, even after trimming whitespace.
		endMarker := []byte("-----END CERTIFICATE-----")
		end := bytes.Index(data, endMarker)
		if end < 0 || bytes.Contains(data[len("-----BEGIN CERTIFICATE-----"):end], []byte("-----BEGIN ")) {
			return errors.New("entitlement CA must contain public certificates only")
		}
		end += len(endMarker)
		block, remaining := pem.Decode(data[:end])
		rest := data[end:]
		if block == nil || len(bytes.TrimSpace(remaining)) != 0 || block.Type != "CERTIFICATE" || len(block.Headers) != 0 {
			return errors.New("entitlement CA must contain public certificates only")
		}
		if _, e = x509.ParseCertificate(block.Bytes); e != nil {
			return errors.New("invalid entitlement CA certificate")
		}
		data = rest
		count++
		if count > 128 {
			return errors.New("entitlement CA certificate limit exceeded")
		}
	}
	if count == 0 {
		return errors.New("entitlement CA bundle is empty")
	}
	return nil
}
