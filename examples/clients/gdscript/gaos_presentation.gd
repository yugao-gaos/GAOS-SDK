class_name GaosPresentationMessage

var schema: String
var type: String
var transition_revision: int = -1
var base_transition_revision: int = -1
var tick: int = -1
var submission_id: String = ""
var optional_fields: Dictionary = {}

static func decode(value: Dictionary) -> GaosPresentationMessage:
    var message := GaosPresentationMessage.new()
    message.schema = value.get("schema", "")
    message.type = value.get("type", "")
    message.transition_revision = value.get("transitionRevision", -1)
    message.base_transition_revision = value.get("baseTransitionRevision", -1)
    message.tick = value.get("tick", -1)
    message.submission_id = value.get("submissionId", "")
    message.optional_fields = value.duplicate(true)
    return message

# Godot projects project stable entity ids into Nodes. A repair replaces the
# durable scene projection and clears old cue/animation queues.
