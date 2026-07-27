#pragma once
#include <cstdint>
#include <map>
#include <optional>
#include <string>

namespace gaos {
struct PresentationMessage {
  std::string schema;
  std::string type;
  std::optional<std::uint64_t> transition_revision;
  std::optional<std::uint64_t> base_transition_revision;
  std::optional<std::uint64_t> tick;
  std::optional<std::string> submission_id;
  // Preserve unknown optional JSON members in the engine's JSON value type.
  std::map<std::string, std::string> optional_json;
};
}  // namespace gaos

// Unreal projects keep stable entity ids beside Actor/UObject projections and
// emit Blueprint events only for new presentation-event ids, never on repair.
