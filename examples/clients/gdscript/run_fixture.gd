extends SceneTree

func _initialize() -> void:
    var fixture = JSON.parse_string(FileAccess.get_file_as_string(OS.get_cmdline_user_args()[0]))
    var state = {"acknowledged": [], "rejected": []}
    var repair_required = false
    for message in fixture.messages:
        if message.type == "snapshot":
            var entity = message.view.entities[0]
            state.merge({"transitionRevision": message.transitionRevision, "tick": message.tick,
                "entityId": entity.id, "x": entity.x, "y": entity.y}, true)
            repair_required = false
        elif message.type == "patch":
            if message.baseTransitionRevision != state.transitionRevision:
                repair_required = true
                continue
            if repair_required:
                continue
            state.merge({"transitionRevision": message.transitionRevision, "tick": message.tick,
                "entityId": message.patch.entityId, "x": message.patch.x, "y": message.patch.y}, true)
        elif message.type == "acknowledgement":
            state.acknowledged.append(message.submissionId)
        elif message.type == "rejection":
            state.rejected.append(message.submissionId)
        elif message.type == "digest-mismatch":
            repair_required = true
    print(JSON.stringify(state))
    quit()
