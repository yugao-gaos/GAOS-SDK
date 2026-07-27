using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Gaos.Presentation;

public sealed record Entity(string id, int x, int y);

public sealed class PresentationMessage
{
    public required string schema { get; init; }
    public required string type { get; init; }
    public int? transitionRevision { get; init; }
    public int? baseTransitionRevision { get; init; }
    public int? tick { get; init; }
    public string? submissionId { get; init; }
    public JsonElement? view { get; init; }
    public JsonElement? patch { get; init; }

    // Compatible minor fields survive decode/re-encode.
    [JsonExtensionData]
    public Dictionary<string, JsonElement> OptionalFields { get; init; } = new();
}

// Unity projects map stable Entity.id values to GameObjects. Apply patches to
// durable state first, then enqueue animation; clear that queue on repair.
