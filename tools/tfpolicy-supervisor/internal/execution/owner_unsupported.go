//go:build !linux

package execution

import (
	"context"
	"errors"
)

func LoadConfig(string) (Config, error) {
	return Config{}, errors.New("native policy owner requires Linux")
}
func execute(context.Context, Config) (Result, error) {
	return Result{}, errors.New("native policy owner requires Linux")
}
func probe(context.Context, Config) error { return errors.New("native policy owner requires Linux") }
