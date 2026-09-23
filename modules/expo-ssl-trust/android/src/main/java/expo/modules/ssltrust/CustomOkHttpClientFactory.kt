package expo.modules.ssltrust

import okhttp3.Dns
import okhttp3.OkHttpClient
import java.net.Inet4Address
import java.net.InetAddress
import java.util.concurrent.TimeUnit
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager

/**
 * Custom OkHttpClient factory that provides an SSL-configured client
 * for React Native's network layer (fetch, Image, etc).
 *
 * Invoked via Proxy from SslTrustStore.installCustomTrustManager().
 */
class CustomOkHttpClientFactory(
    private val sslSocketFactory: SSLSocketFactory,
    private val trustManager: X509TrustManager
) {
    fun createNewNetworkModuleClient(): OkHttpClient {
        // Base on RN's OWN builder — it carries the config NetworkingModule REQUIRES,
        // notably a `ReactCookieJarContainer`. A bare `OkHttpClient.Builder()` leaves
        // the default `CookieJar.NO_COOKIES`, which RN then casts to `CookieJarContainer`
        // → hard crash ("NoCookies cannot be cast to CookieJarContainer"). We ADD only
        // the pinned SSL socket factory + hostname verifier on top.
        //
        // Reflection (not a direct import): this module does not compile-depend on
        // react-android — RN is provided by the host app at runtime — same pattern as
        // SslTrustStore. `createClientBuilder()` does NOT consult the factory, so no
        // recursion.
        val builder = try {
            val providerClass = Class.forName("com.facebook.react.modules.network.OkHttpClientProvider")
            val createClientBuilder = providerClass.getMethod("createClientBuilder")
            createClientBuilder.invoke(null) as OkHttpClient.Builder
        } catch (e: Exception) {
            android.util.Log.w("SslTrustStore", "createClientBuilder() reflection failed: ${e.message}")
            OkHttpClient.Builder()
        }
        // RN's builder sets connectTimeout(0): on networks that resolve AAAA but drop
        // IPv6 traffic, the first (IPv6) route then hangs until the OS gives up
        // ("Failed to connect to /<v6 addr>:443") and IPv4 is never tried in time.
        // Try IPv4 first and bound each connect attempt so OkHttp falls through.
        return builder
            .dns(Ipv4FirstDns)
            .connectTimeout(8, TimeUnit.SECONDS)
            .sslSocketFactory(sslSocketFactory, trustManager)
            .hostnameVerifier(CustomHostnameVerifier())
            .build()
    }

    private object Ipv4FirstDns : Dns {
        override fun lookup(hostname: String): List<InetAddress> =
            Dns.SYSTEM.lookup(hostname).sortedBy { if (it is Inet4Address) 0 else 1 }
    }

    /**
     * Custom hostname verifier that allows connections to trusted hosts
     * even when the certificate's CN/SAN doesn't match (common with
     * self-signed certs accessed via IP or non-standard hostname).
     */
    class CustomHostnameVerifier : HostnameVerifier {
        private val defaultVerifier = javax.net.ssl.HttpsURLConnection.getDefaultHostnameVerifier()

        override fun verify(hostname: String, session: javax.net.ssl.SSLSession): Boolean {
            // First try the default verifier
            if (defaultVerifier.verify(hostname, session)) {
                return true
            }

            // If default fails, check if this hostname is in our trust store
            return try {
                val certs = session.peerCertificates
                if (certs.isNotEmpty() && certs[0] is java.security.cert.X509Certificate) {
                    val x509 = certs[0] as java.security.cert.X509Certificate
                    val fingerprint = SslTrustStore.getFingerprint(x509)
                    SslTrustStore.isCertificateTrusted(hostname) ||
                        SslTrustStore.getTrustedCertificates().any { cert ->
                            cert["sha256Fingerprint"] == fingerprint
                        }
                } else {
                    false
                }
            } catch (e: Exception) {
                false
            }
        }
    }
}
