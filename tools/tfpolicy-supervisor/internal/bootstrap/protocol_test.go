package bootstrap

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"
)

func certificate(t *testing.T) (string, string) {
	t.Helper()
	k, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	der, e := x509.CreateCertificate(rand.Reader, &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}, &x509.Certificate{SerialNumber: big.NewInt(1)}, &k.PublicKey, k)
	if e != nil {
		t.Fatal(e)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), base64.RawStdEncoding.EncodeToString(der)
}
func TestRequestRejectsPrivateAndExtraData(t *testing.T) {
	cert, _ := certificate(t)
	good := Request{cert, "1", Cookie}
	if e := good.Validate(); e != nil {
		t.Fatal(e)
	}
	for _, r := range []Request{{"junk" + cert, "1", Cookie}, {cert + cert, "1", Cookie}, {strings.Replace(cert, "CERTIFICATE", "PRIVATE KEY", -1), "1", Cookie}, {cert, "1,,2", Cookie}, {cert, "01", Cookie}, {cert, "1", "wrong"}} {
		if r.Validate() == nil {
			t.Fatal("invalid request accepted")
		}
	}
	b, _ := json.Marshal(good)
	if _, e := DecodeRequest(append(b, []byte(" {}")...)); e == nil {
		t.Fatal("trailing JSON accepted")
	}
	if _, e := DecodeRequest([]byte(`{"arbitrary_launch":"/bin/sh"}`)); e == nil {
		t.Fatal("unknown launch field accepted")
	}
}
func TestBoundedLine(t *testing.T) {
	for _, s := range []string{strings.Repeat("x", 8192) + "\n", "no newline"} {
		if _, e := ReadLine(bufio.NewReader(strings.NewReader(s)), 4096); e == nil {
			t.Fatal("invalid line accepted")
		}
	}
	b, e := ReadLine(bufio.NewReader(strings.NewReader("abc\nrest")), 4)
	if e != nil || string(b) != "abc\n" {
		t.Fatal(string(b), e)
	}
}
func TestStatParsing(t *testing.T) {
	fields := []string{"S", "123"}
	for len(fields) < 19 {
		fields = append(fields, "0")
	}
	fields = append(fields, "999")
	p, s, e := ParseStat("456 (tricky ) name) " + strings.Join(fields, " "))
	if e != nil || p != 123 || s != 999 {
		t.Fatal(p, s, e)
	}
	for _, s := range []string{"", "1 (bad) S 3", "1 no delimiter"} {
		if _, _, e := ParseStat(s); e == nil {
			t.Fatal("invalid stat accepted")
		}
	}
}
func TestHandshakeRequiresMTLS(t *testing.T) {
	_, cert := certificate(t)
	good := "1|1|unix|/private/plugin.sock|grpc|" + cert + "\n"
	if e := ValidateHandshake([]byte(good)); e != nil {
		t.Fatal(e)
	}
	for _, s := range []string{"1|1|unix|/tmp/p|grpc|\n", strings.Replace(good, "|grpc|", "|netrpc|", 1), strings.Replace(good, cert, "bogus", 1), good + "extra", strings.Replace(good, "1|1|", "1|99|", 1)} {
		if ValidateHandshake([]byte(s)) == nil {
			t.Fatal("invalid handshake accepted")
		}
	}
}

func TestConfigBounds(t *testing.T) {
	base := Config{SocketPath: "/private/sock", EnginePID: 123, EngineStartTime: 1, PeerUID: 1000, ShimPath: "/trusted/shim", ShimSHA256: strings.Repeat("a", 64), RecorderPath: "/trusted/recorder", RecorderSHA256: strings.Repeat("b", 64), RecorderConfigPath: "/private/recorder.json", JournalPath: "/private/journal", RunNonce: strings.Repeat("c", 64), StartupSeconds: 10, LifetimeSeconds: 3600, MaxJournalBytes: 1 << 20}
	if e := base.Validate(); e != nil {
		t.Fatal(e)
	}
	for _, mutate := range []func(*Config){
		func(c *Config) { c.SocketPath = "relative.sock" },
		func(c *Config) { c.JournalPath = "/private/../workspace/journal" },
		func(c *Config) { c.ShimSHA256 = strings.Repeat("A", 64) },
		func(c *Config) { c.EngineStartTime = 0 },
		func(c *Config) { c.StartupSeconds = 0 },
		func(c *Config) { c.LifetimeSeconds = 86401 },
		func(c *Config) { c.MaxJournalBytes = 65 << 20 },
		func(c *Config) { c.RecorderConfigPath = "" },
	} {
		c := base
		mutate(&c)
		if c.Validate() == nil {
			t.Fatalf("invalid config accepted: %+v", c)
		}
	}
}
