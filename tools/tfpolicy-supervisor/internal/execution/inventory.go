package execution

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"
)

// These are static module/provider configuration addresses, not resource
// instance addresses. JSON configuration has already resolved provider passing
// and inheritance to the source provider_config_key.
var moduleAddress = regexp.MustCompile(`^(module\.[\pL_][\pL\pN_-]*)(\.module\.[\pL_][\pL\pN_-]*)*$`)
var identifier = regexp.MustCompile(`^[\pL_][\pL\pN_-]*$`)
var providerAddress = regexp.MustCompile(`^(module\.[\pL_][\pL\pN_-]*\.)*provider\["[^"\\\x00-\x1f]+"\](\.[\pL_][\pL\pN_-]*)?$`)

type configurationModule struct {
	Resources []struct {
		ProviderKey string `json:"provider_config_key"`
	} `json:"resources"`
	Calls map[string]struct {
		Module *configurationModule `json:"module"`
	} `json:"module_calls"`
}

// metadataTargets never consumes graph registration or policy output. It reads
// the pinned engine's saved-plan configuration and the exact archive's prior
// state, so even omission of an entire graph registration remains detectable.
func metadataTargets(planJSON, archive []byte) (map[Target]int, error) {
	var plan struct {
		Configuration *struct {
			Providers map[string]struct {
				Source string `json:"full_name"`
				Alias  string `json:"alias"`
				Module string `json:"module_address"`
			} `json:"provider_config"`
			Root *configurationModule `json:"root_module"`
		} `json:"configuration"`
	}
	if len(planJSON) > CaptureLimit || json.Unmarshal(planJSON, &plan) != nil || plan.Configuration == nil || plan.Configuration.Root == nil {
		return nil, errors.New("saved plan omitted independent native configuration")
	}
	out := map[Target]int{}
	entries := 0
	var visit func(*configurationModule, string, int) error
	visit = func(module *configurationModule, path string, depth int) error {
		if module == nil || depth > 64 {
			return errors.New("invalid native module configuration")
		}
		entries += len(module.Resources) + len(module.Calls)
		if entries > 10000 {
			return errors.New("native configuration inventory exceeds limit")
		}
		for _, resource := range module.Resources {
			provider, ok := plan.Configuration.Providers[resource.ProviderKey]
			if !ok || len(strings.Split(provider.Source, "/")) != 3 || len(provider.Source) > 512 || provider.Module != "" && !moduleAddress.MatchString(provider.Module) || provider.Alias != "" && !identifier.MatchString(provider.Alias) {
				return errors.New("saved plan has an unresolved provider configuration")
			}
			address := "provider[" + strconv.Quote(provider.Source) + "]"
			if provider.Module != "" {
				address = provider.Module + "." + address
			}
			if provider.Alias != "" {
				address += "." + provider.Alias
			}
			if !providerAddress.MatchString(address) {
				return errors.New("invalid saved provider address")
			}
			out[Target{Kind: "provider", Address: address}] = 1
		}
		for name, child := range module.Calls {
			if !identifier.MatchString(name) {
				return errors.New("invalid saved module address")
			}
			address := "module." + name
			if path != "" {
				address = path + "." + address
			}
			out[Target{Kind: "module", Address: address}] = 1
			if err := visit(child.Module, address, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	if err := visit(plan.Configuration.Root, "", 0); err != nil {
		return nil, err
	}
	providers, err := stateProviderTargets(archive)
	if err != nil {
		return nil, err
	}
	for target := range providers {
		out[target] = 1
	}
	return out, nil
}

// Prior-state provider addresses retain aliases and legacy module scopes that
// the public show JSON's provider_name deliberately omits. They are needed for
// orphan deletes after a resource or module was removed from configuration.
func stateProviderTargets(archive []byte) (map[Target]int, error) {
	if len(archive) == 0 || len(archive) > CaptureLimit {
		return nil, errors.New("immutable saved plan archive missing or oversized")
	}
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return nil, errors.New("invalid immutable plan archive")
	}
	var data []byte
	for _, file := range reader.File {
		if file.Name != "tfstate" {
			continue
		}
		if data != nil || file.UncompressedSize64 > CaptureLimit {
			return nil, errors.New("duplicated or oversized saved prior state")
		}
		stream, err := file.Open()
		if err != nil {
			return nil, err
		}
		data, err = io.ReadAll(io.LimitReader(stream, CaptureLimit+1))
		closeErr := stream.Close()
		if err != nil || closeErr != nil || len(data) > CaptureLimit {
			return nil, errors.New("invalid bounded saved prior state")
		}
	}
	var state struct {
		Version   int `json:"version"`
		Resources []struct {
			Mode      string            `json:"mode"`
			Provider  string            `json:"provider"`
			Instances []json.RawMessage `json:"instances"`
		} `json:"resources"`
	}
	if json.Unmarshal(data, &state) != nil || state.Version != 4 || len(state.Resources) > 10000 {
		return nil, errors.New("unsupported saved prior state")
	}
	out := map[Target]int{}
	for _, resource := range state.Resources {
		if resource.Mode != "managed" || len(resource.Instances) == 0 {
			continue
		}
		if !providerAddress.MatchString(resource.Provider) || len(resource.Provider) > 4096 {
			return nil, errors.New("invalid prior-state provider address")
		}
		out[Target{Kind: "provider", Address: resource.Provider}] = 1
	}
	return out, nil
}
