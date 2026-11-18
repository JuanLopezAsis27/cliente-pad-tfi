using System.Diagnostics;
using System.Text;

// Cliente de prueba del web service SOAP de ArcaSim (WSFEv1).
//
// Es un sistema externo, como el de cualquier grupo que facture con ArcaSim: no comparte código con
// la solución, solo conoce la URL del servicio, la API key y la CUIT. La interfaz (wwwroot) arma los
// sobres SOAP y este servidor los reenvía tal cual a la URL indicada. El reenvío existe porque la API
// no habilita CORS (los clientes reales llaman desde su servidor, no desde el navegador).

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHttpClient("soap", cliente =>
{
    // Render Free apaga el servicio sin uso: el primer pedido puede tardar cerca de un minuto.
    cliente.Timeout = TimeSpan.FromSeconds(90);
    cliente.DefaultRequestHeaders.UserAgent.ParseAdd("ArcaSim.ClienteSoap/1.0");
});

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

// Envía un sobre SOAP 1.1 y devuelve la respuesta sin tocarla (código HTTP, tiempo y cuerpo).
app.MapPost("/api/soap", async (PedidoSoap pedido, IHttpClientFactory fabrica, CancellationToken ct) =>
{
    if (!EsUrlHttp(pedido.Url, out var url))
    {
        return Results.BadRequest(new { error = "La URL del servicio debe empezar con http:// o https://." });
    }

    using var mensaje = new HttpRequestMessage(HttpMethod.Post, url)
    {
        Content = new StringContent(pedido.Xml ?? string.Empty, Encoding.UTF8, "text/xml")
    };
    // SOAP 1.1: el header lleva la acción entre comillas.
    mensaje.Headers.TryAddWithoutValidation("SOAPAction", $"\"{pedido.Accion}\"");

    return await EnviarAsync(fabrica, mensaje, ct);
});

// Descarga el WSDL del servicio (GET a la URL con ?WSDL).
app.MapGet("/api/wsdl", async (string url, IHttpClientFactory fabrica, CancellationToken ct) =>
{
    if (!EsUrlHttp(url, out var servicio))
    {
        return Results.BadRequest(new { error = "La URL del servicio debe empezar con http:// o https://." });
    }

    var wsdl = new UriBuilder(servicio) { Query = "WSDL" }.Uri;
    using var mensaje = new HttpRequestMessage(HttpMethod.Get, wsdl);
    return await EnviarAsync(fabrica, mensaje, ct);
});

app.Run();

static bool EsUrlHttp(string? texto, out Uri url)
{
    if (Uri.TryCreate(texto?.Trim(), UriKind.Absolute, out var u)
        && (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps))
    {
        url = u;
        return true;
    }

    url = null!;
    return false;
}

static async Task<IResult> EnviarAsync(IHttpClientFactory fabrica, HttpRequestMessage mensaje, CancellationToken ct)
{
    var reloj = Stopwatch.StartNew();
    try
    {
        using var respuesta = await fabrica.CreateClient("soap").SendAsync(mensaje, ct);
        var cuerpo = await respuesta.Content.ReadAsStringAsync(ct);
        return Results.Ok(new RespuestaSoap(
            Url: mensaje.RequestUri!.ToString(),
            Estado: (int)respuesta.StatusCode,
            Motivo: respuesta.ReasonPhrase,
            Milisegundos: reloj.ElapsedMilliseconds,
            TipoContenido: respuesta.Content.Headers.ContentType?.ToString(),
            Cuerpo: cuerpo,
            Error: null));
    }
    catch (HttpRequestException e)
    {
        return Results.Ok(SinRespuesta(mensaje, reloj, $"No se pudo conectar con el servicio: {e.Message}"));
    }
    catch (TaskCanceledException) when (!ct.IsCancellationRequested)
    {
        return Results.Ok(SinRespuesta(mensaje, reloj, "El servicio no respondió en 90 segundos."));
    }
}

static RespuestaSoap SinRespuesta(HttpRequestMessage mensaje, Stopwatch reloj, string error) =>
    new(mensaje.RequestUri!.ToString(), 0, null, reloj.ElapsedMilliseconds, null, null, error);

internal sealed record PedidoSoap(string? Url, string? Accion, string? Xml);

internal sealed record RespuestaSoap(
    string Url,
    int Estado,
    string? Motivo,
    long Milisegundos,
    string? TipoContenido,
    string? Cuerpo,
    string? Error);
