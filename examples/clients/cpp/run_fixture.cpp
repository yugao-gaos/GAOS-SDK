#include <fstream>
#include <iostream>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

static std::string read_all(const char* path) {
  std::ifstream input(path);
  if (!input) throw std::runtime_error("fixture is unreadable");
  return {std::istreambuf_iterator<char>(input), {}};
}
static std::string string_field(const std::string& value, const std::string& key) {
  std::smatch match;
  std::regex pattern("\"" + key + "\"\\s*:\\s*\"([^\"]*)\"");
  if (!std::regex_search(value, match, pattern)) throw std::runtime_error("missing string field " + key);
  return match[1];
}
static int int_field(const std::string& value, const std::string& key) {
  std::smatch match;
  std::regex pattern("\"" + key + "\"\\s*:\\s*(-?[0-9]+)");
  if (!std::regex_search(value, match, pattern)) throw std::runtime_error("missing integer field " + key);
  return std::stoi(match[1]);
}
static std::string object_field(const std::string& value, const std::string& key) {
  const auto key_pos = value.find("\"" + key + "\"");
  const auto start = value.find('{', key_pos);
  int depth = 0;
  for (auto index = start; index < value.size(); ++index) {
    if (value[index] == '{') ++depth;
    if (value[index] == '}' && --depth == 0) return value.substr(start, index - start + 1);
  }
  throw std::runtime_error("unterminated object " + key);
}
static std::vector<std::string> message_objects(const std::string& value) {
  const auto messages = value.find("\"messages\"");
  const auto start = value.find('[', messages);
  std::vector<std::string> result;
  int depth = 0;
  std::size_t object_start = 0;
  for (auto index = start + 1; index < value.size(); ++index) {
    if (value[index] == '{') {
      if (depth++ == 0) object_start = index;
    } else if (value[index] == '}' && --depth == 0) {
      result.push_back(value.substr(object_start, index - object_start + 1));
    } else if (value[index] == ']' && depth == 0) break;
  }
  return result;
}
int main(int argc, char** argv) {
  if (argc != 2) return 2;
  int revision = -1, tick = -1, x = 0, y = 0;
  std::string entity_id;
  std::vector<std::string> acknowledged;
  std::vector<std::string> rejected;
  bool repair_required = false;
  for (const auto& message : message_objects(read_all(argv[1]))) {
    const auto type = string_field(message, "type");
    if (type == "snapshot") {
      const auto view = object_field(message, "view");
      revision = int_field(message, "transitionRevision");
      tick = int_field(message, "tick");
      entity_id = string_field(view, "id");
      x = int_field(view, "x"); y = int_field(view, "y");
      repair_required = false;
    } else if (type == "patch") {
      if (int_field(message, "baseTransitionRevision") != revision) {
        repair_required = true;
        continue;
      }
      if (repair_required) continue;
      const auto patch = object_field(message, "patch");
      revision = int_field(message, "transitionRevision");
      tick = int_field(message, "tick");
      entity_id = string_field(patch, "entityId");
      x = int_field(patch, "x"); y = int_field(patch, "y");
    } else if (type == "acknowledgement") {
      acknowledged.push_back(string_field(message, "submissionId"));
    } else if (type == "rejection") {
      rejected.push_back(string_field(message, "submissionId"));
    } else if (type == "digest-mismatch") {
      repair_required = true;
    }
  }
  std::cout << "{\"transitionRevision\":" << revision << ",\"tick\":" << tick
            << ",\"entityId\":\"" << entity_id << "\",\"x\":" << x << ",\"y\":" << y
            << ",\"acknowledged\":[\"" << acknowledged.front() << "\"]"
            << ",\"rejected\":[\"" << rejected.front() << "\"]}\n";
}
