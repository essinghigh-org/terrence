package recorder

import (
	"context"
	"errors"
	"sync"

	"github.com/hashicorp/go-plugin"
	p "github.com/hashicorp/terraform/internal/policy/proto"
	"google.golang.org/grpc"
)

// BridgeBrokers translates the callback service ID across the two independent
// go-plugin connections. Terraform remains the callback implementation.
// Its protocol forwarding is exercised by in-memory transport tests and the
// separate stock-Terraform compatibility harness.
// The caller must defer cleanup and reject a failure to establish the bridge.
func BridgeBrokers(upstream, downstream *plugin.GRPCBroker, journal *Journal) (func(context.Context, uint32) (uint32, error), func()) {
	var mu sync.Mutex
	var conn *grpc.ClientConn
	var server *grpc.Server
	closed := false
	cleanup := func() {
		mu.Lock()
		defer mu.Unlock()
		closed = true
		if server != nil {
			server.Stop()
		}
		if conn != nil {
			_ = conn.Close()
		}
	}
	bridge := func(ctx context.Context, id uint32) (uint32, error) {
		if id == 0 {
			return 0, errors.New("missing callback service")
		}
		c, err := upstream.Dial(id)
		if err != nil {
			return 0, err
		}
		mu.Lock()
		if closed {
			mu.Unlock()
			c.Close()
			return 0, errors.New("bridge closed")
		}
		conn = c
		mu.Unlock()
		destination := downstream.NextId()
		ready := make(chan struct{})
		done := make(chan struct{})
		go func() {
			defer close(done)
			downstream.AcceptAndServe(destination, func(options []grpc.ServerOption) *grpc.Server {
				srv := grpc.NewServer(options...)
				p.RegisterCallbackServiceServer(srv, &CallbackRelay{Client: p.NewCallbackServiceClient(c), Journal: journal})
				mu.Lock()
				server = srv
				if closed {
					srv.Stop()
				}
				mu.Unlock()
				close(ready)
				return srv
			})
		}()
		select {
		case <-ctx.Done():
			cleanup()
			return 0, ctx.Err()
		case <-ready:
		case <-done:
			cleanup()
			return 0, errors.New("callback broker stopped before readiness")
		}
		mu.Lock()
		defer mu.Unlock()
		if closed {
			return 0, errors.New("bridge closed")
		}
		return destination, nil
	}
	return bridge, cleanup
}
