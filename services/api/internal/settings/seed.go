package settings

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// DefaultSeedPath is where config/defaults.yaml sits relative to services/api.
const DefaultSeedPath = "../../config/defaults.yaml"

// LoadSeed reads config/defaults.yaml into a flat dotted-key map.
//
// A missing file is not an error: the built-in defaults in Defs are the final
// fallback, so the service still starts. A file that exists but does not parse
// IS an error -- an operator who wrote a seed file expects it to be in effect,
// and silently ignoring it is the invisible-source failure ADR-0007 exists to
// prevent.
func LoadSeed(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]string{}, nil
		}
		return nil, fmt.Errorf("reading seed %s: %w", path, err)
	}

	var doc map[string]any
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("parsing seed %s: %w", path, err)
	}

	out := map[string]string{}
	if err := flatten("", doc, out); err != nil {
		return nil, fmt.Errorf("in seed %s: %w", path, err)
	}
	return out, nil
}

func flatten(prefix string, node map[string]any, out map[string]string) error {
	keys := make([]string, 0, len(node))
	for k := range node {
		keys = append(keys, k)
	}
	sort.Strings(keys) // deterministic errors

	for _, k := range keys {
		key := k
		if prefix != "" {
			key = prefix + "." + k
		}
		switch v := node[k].(type) {
		case map[string]any:
			if err := flatten(key, v, out); err != nil {
				return err
			}
		case []any:
			encoded, err := encodeList(key, v)
			if err != nil {
				return err
			}
			out[key] = encoded
		case nil:
			// An explicitly empty value means "use the tier below", not "".
			continue
		default:
			out[key] = fmt.Sprint(v)
		}
	}
	return nil
}

// encodeList renders a YAML sequence into the flat string form the matching Def
// parses. Only the shapes we actually define are accepted; an unrecognised list
// is an error rather than a silently mangled setting.
func encodeList(key string, items []any) (string, error) {
	switch key {
	case "sensors.expected":
		parts := make([]string, 0, len(items))
		for i, item := range items {
			m, ok := item.(map[string]any)
			if !ok {
				return "", fmt.Errorf("%s[%d]: expected a mapping with id and kind", key, i)
			}
			id, _ := m["id"].(string)
			kind, _ := m["kind"].(string)
			if id == "" || kind == "" {
				return "", fmt.Errorf("%s[%d]: needs both id and kind", key, i)
			}
			parts = append(parts, id+":"+kind)
		}
		return strings.Join(parts, ","), nil
	default:
		return "", fmt.Errorf("%s: lists are not supported for this setting", key)
	}
}
