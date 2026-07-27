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

public static class Program
{
    public static void Main(string[] args)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(args[0]));
        int revision = -1, tick = -1, x = 0, y = 0;
        string entityId = "";
        var acknowledged = new List<string>();
        var rejected = new List<string>();
        bool repairRequired = false;
        foreach (var message in document.RootElement.GetProperty("messages").EnumerateArray())
        {
            var type = message.GetProperty("type").GetString();
            if (type == "snapshot")
            {
                var entity = message.GetProperty("view").GetProperty("entities")[0];
                revision = message.GetProperty("transitionRevision").GetInt32();
                tick = message.GetProperty("tick").GetInt32();
                entityId = entity.GetProperty("id").GetString()!;
                x = entity.GetProperty("x").GetInt32();
                y = entity.GetProperty("y").GetInt32();
                repairRequired = false;
            }
            else if (type == "patch")
            {
                if (message.GetProperty("baseTransitionRevision").GetInt32() != revision)
                {
                    repairRequired = true;
                    continue;
                }
                if (repairRequired) continue;
                var patch = message.GetProperty("patch");
                revision = message.GetProperty("transitionRevision").GetInt32();
                tick = message.GetProperty("tick").GetInt32();
                entityId = patch.GetProperty("entityId").GetString()!;
                x = patch.GetProperty("x").GetInt32();
                y = patch.GetProperty("y").GetInt32();
            }
            else if (type == "acknowledgement")
                acknowledged.Add(message.GetProperty("submissionId").GetString()!);
            else if (type == "rejection")
                rejected.Add(message.GetProperty("submissionId").GetString()!);
            else if (type == "digest-mismatch")
                repairRequired = true;
        }
        Console.WriteLine(JsonSerializer.Serialize(new {
            transitionRevision = revision, tick, entityId, x, y, acknowledged, rejected
        }));
    }
}
